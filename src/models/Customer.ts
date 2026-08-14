import { Schema, model, Types } from 'mongoose';

export interface ICustomerAddress {
  label?: string;
  address: string;
  reference?: string;
}

export interface ICustomer {
  _id: Types.ObjectId;
  tenant: Types.ObjectId;
  name: string;
  phone: string;
  email?: string;
  addresses: ICustomerAddress[];
  createdAt: Date;
  updatedAt: Date;
}

const addressSchema = new Schema<ICustomerAddress>(
  {
    label: { type: String },
    address: { type: String, required: true },
    reference: { type: String },
  },
  { _id: false }
);

const customerSchema = new Schema<ICustomer>(
  {
    tenant: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true },
    email: { type: String },
    addresses: { type: [addressSchema], default: [] },
  },
  { timestamps: true }
);

customerSchema.index({ tenant: 1, phone: 1 });

export const Customer = model<ICustomer>('Customer', customerSchema);
