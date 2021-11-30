import { Customers, Fields } from '../db/models';
import { IBrandDocument } from '../db/models/definitions/brands';
import { ICustomer } from '../db/models/definitions/customers';
import { IUser } from '../db/models/definitions/users';
import { getCustomFields } from './modules/fields/utils';
import { generateAmounts, generateProducts } from './resolvers/deals';
import * as _ from 'underscore';
import { URL } from 'url';
import { getSubServiceDomain } from './utils';
import { ICustomField } from '../db/models/definitions/common';

export interface IReplacer {
  key: string;
  value: string;
}

export interface IArgs {
  content: string;
  possibleCustomerFields: ICustomerField[];
  customer?: ICustomer | null;
  user?: IUser | null;
  customerFields?: string[];
  item?: any;
  brand?: IBrandDocument;
}

export interface ICustomerField {
  _id: number;
  name: string;
  group?: string;
  label?: string;
  type?: string;
  validation?: string;
  options?: string[];
  selectOptions?: Array<{ label: string; value: string }>;
}

const isValidURL = (url: string) => {
  try {
    return Boolean(new URL(url));
  } catch (e) {
    return false;
  }
};

const fileToFileLink = async (url?: string, name?: string): Promise<string> => {
  if (!url) {
    return '';
  }

  let href: string;
  if (isValidURL(url) || url.includes('/')) {
    href = url;
  } else {
    const API_DOMAIN = getSubServiceDomain({ name: 'API_DOMAIN' });
    const key = url;
    const uriName = name ? encodeURIComponent(name) : url;
    href = `${API_DOMAIN}/read-file?key=${key}&name=${uriName}`;
  }

  return `<a target="_blank" download href="${href}">${name || url}</a>`;
};

export const customFieldsDataItemToFileLink = async (
  customFieldDataItem: any
): Promise<string> => {
  const value = customFieldDataItem.value;

  if (Array.isArray(value)) {
    const links = await Promise.all(
      value.map(v => fileToFileLink(v.url, v.name))
    );
    return links.join(' | ');
  }

  return fileToFileLink(value.url, value.name);
};

export function runReplacersOn(
  content: string,
  replacers: IReplacer[] = []
): string {
  let replacedContent = content;

  for (const replacer of replacers) {
    const regex = new RegExp(replacer.key, 'gi');

    replacedContent = replacedContent.replace(regex, replacer.value);
  }

  return replacedContent;
}

export function getCustomerFields(
  content: string,
  possibleCustomerFields: ICustomerField[]
): string[] {
  const customerFields = ['firstName', 'lastName', 'middleName'];

  for (const field of possibleCustomerFields) {
    if (!content.includes(`{{ customer.${field.name} }}`)) {
      continue;
    }

    if (field.name.includes('trackedData')) {
      customerFields.push('trackedData');
      continue;
    }

    if (field.name.includes('customFieldsData')) {
      customerFields.push('customFieldsData');
      continue;
    }

    customerFields.push(field.name);
  }

  return customerFields;
}

export function fillMissingCustomFieldsDataItem(
  content: string,
  customFieldsData: ICustomField[] = [],
  possibleCustomerFields: ICustomerField[]
): ICustomField[] {
  const filledResult = [...customFieldsData];

  for (const field of possibleCustomerFields) {
    if (!content.includes(`{{ customer.${field.name} }}`)) {
      continue;
    }

    if (field.name.includes('customFieldsData')) {
      const fieldId = field.name.split('.').pop();

      // if content has field attribute that doesn't exist on the customer, fill with dummy customFieldsData item
      if (!filledResult.find(e => e.field === fieldId)) {
        filledResult.push({
          field: fieldId || '',
          stringValue: '',
          value: ''
        });
      }
      continue;
    }
  }

  return filledResult;
}

export async function generateReplacers(args: IArgs): Promise<IReplacer[]> {
  const { content, user, brand, item, possibleCustomerFields } = args;
  const customer = args.customer || {};
  const replacers: IReplacer[] = [];

  let customerFields = args.customerFields;

  if (!customerFields || customerFields.length === 0) {
    customerFields = getCustomerFields(content, possibleCustomerFields);
  }

  customer.customFieldsData = fillMissingCustomFieldsDataItem(
    content,
    customer.customFieldsData,
    possibleCustomerFields
  );

  // replace customer fields
  if (args.customer) {
    replacers.push({
      key: '{{ customer.name }}',
      value: Customers.getCustomerName(customer)
    });

    const customerFileFieldsById = _.indexBy(
      await Fields.find({ type: 'file', contentType: 'customer' }),
      '_id'
    );

    for (const field of customerFields) {
      if (field.includes('trackedData') || field.includes('customFieldsData')) {
        const dbFieldName = field.includes('trackedData')
          ? 'trackedData'
          : 'customFieldsData';

        for (const customFieldsDataItem of customer[dbFieldName] || []) {
          const replaceValue = customerFileFieldsById[
            customFieldsDataItem.field
          ]
            ? await customFieldsDataItemToFileLink(customFieldsDataItem)
            : customFieldsDataItem.stringValue ||
              customFieldsDataItem.value ||
              '';

          replacers.push({
            key: `{{ customer.${dbFieldName}.${customFieldsDataItem.field} }}`,
            value: replaceValue
          });
        }

        continue;
      }

      replacers.push({
        key: `{{ customer.${field} }}`,
        value: customer[field] || ''
      });
    }
  }

  // replace user fields
  if (user) {
    replacers.push({ key: '{{ user.email }}', value: user.email || '' });

    if (user.details) {
      replacers.push({
        key: '{{ user.fullName }}',
        value: user.details.fullName || ''
      });
      replacers.push({
        key: '{{ user.position }}',
        value: user.details.position || ''
      });
    }
  }

  // replace brand fields
  if (brand) {
    replacers.push({ key: '{{ brandName }}', value: brand.name || '' });
  }

  // deal, ticket, task mapping
  if (item) {
    replacers.push({ key: '{{ itemName }}', value: item.name || '' });
    replacers.push({
      key: '{{ itemDescription }}',
      value: item.description || ''
    });

    replacers.push({
      key: '{{ itemCloseDate }}',
      value: item.closeDate ? new Date(item.closeDate).toLocaleDateString() : ''
    });
    replacers.push({
      key: '{{ itemCreatedAt }}',
      value: item.createdAt ? new Date(item.createdAt).toLocaleDateString() : ''
    });
    replacers.push({
      key: '{{ itemModifiedAt }}',
      value: item.modifiedAt
        ? new Date(item.modifiedAt).toLocaleDateString()
        : ''
    });

    const products = await generateProducts(item.productsData);
    const amounts = generateAmounts(item.productsData);

    replacers.push({
      key: '{{ dealProducts }}',
      value: products.map(p => p.product.name).join(',')
    });
    replacers.push({
      key: '{{ dealAmounts }}',
      value: Object.keys(amounts)
        .map(key => `${amounts[key]}${key}`)
        .join(',')
    });

    const customFields = await getCustomFields(item.contentType);

    for (const customField of customFields) {
      const customFieldsData = item.customFieldsData || [];
      const customFieldsDataItem = customFieldsData.find(
        c => c.field === customField._id
      );

      if (!customFieldsDataItem) continue;

      const replaceValue =
        customField.type === 'file'
          ? await customFieldsDataItemToFileLink(customFieldsDataItem)
          : customFieldsDataItem.stringValue ||
            customFieldsDataItem.value ||
            '';

      replacers.push({
        key: `{{ itemCustomField.${customField._id} }}`,
        value: replaceValue
      });
    }
  }

  return replacers;
}

export async function replaceContent(args: IArgs): Promise<string> {
  const replacers: IReplacer[] = await generateReplacers(args);
  const replacedContent = runReplacersOn(args.content, replacers);
  return replacedContent;
}
