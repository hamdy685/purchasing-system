<?php

namespace App\Http\Requests\Procurement;

use App\Models\Supplier;
use Illuminate\Foundation\Http\FormRequest;

class CreatePurchaseOrderRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'purchase_request_id' => ['required', 'integer', 'exists:purchase_requests,id'],
            'supplier_id' => ['nullable', 'integer', 'exists:suppliers,id'],
            'one_time_supplier_name' => ['nullable', 'string', 'max:150'],
            'payment_terms' => ['nullable', 'string', 'max:150'],
            'delivery_terms' => ['nullable', 'string', 'max:150'],
            'delivery_date' => ['nullable', 'date'],
            'budget_code' => ['nullable', 'string', 'max:50'],
            'notes' => ['nullable', 'string'],
            'items' => ['nullable', 'array'],
            'items.*.pr_item_id' => ['nullable', 'integer'],
            'items.*.item_id' => ['nullable', 'integer'],
            'items.*.item_description' => ['nullable', 'string', 'max:255'],
            'items.*.item_reference' => ['required', 'string', 'max:100'],
            'items.*.region' => ['required', 'string', 'max:150'],
            'items.*.quantity' => ['nullable', 'numeric', 'gt:0'],
            'items.*.uom' => ['nullable', 'string', 'max:20'],
            'items.*.unit_price' => ['nullable', 'numeric', 'gte:0'],
            'items.*.specifications' => ['nullable', 'string'],
            'items.*.change_reason' => ['nullable', 'string'],
            'items.*.supplier_id' => ['nullable', 'integer', 'exists:suppliers,id'],
            // Client-generated per issue attempt; a retry with the same key returns the orders already issued.
            'idempotency_key' => ['nullable', 'string', 'regex:/^[A-Za-z0-9-]{8,48}$/'],
            'groups' => ['nullable', 'array'],
            'groups.*.group_name' => ['nullable', 'string', 'max:150'],
            'groups.*.group_type' => ['nullable', 'string', 'in:SHARED_SHIPMENT,STEEL_WEIGHING,NONE'],
            'groups.*.supplier_id' => ['nullable', 'integer', 'exists:suppliers,id'],
            'groups.*.one_time_supplier_name' => ['nullable', 'string', 'max:150'],
            'groups.*.payment_terms' => ['nullable', 'string', 'max:150'],
            'groups.*.delivery_date' => ['nullable', 'date'],
            'groups.*.notes' => ['nullable', 'string', 'max:1000'],
            'groups.*.items' => ['required_with:groups', 'array', 'min:1'],
        ];
    }


    public function withValidator($validator): void
    {
        $validator->after(function ($validator) {
            $supplierId = $this->input('supplier_id');
            $oneTimeName = trim((string) $this->input('one_time_supplier_name', ''));

            $hasGroups = $this->has('groups') && is_array($this->input('groups')) && count($this->input('groups')) > 0;
            if ($hasGroups) {
                foreach ($this->input('groups') as $idx => $grp) {
                    $grpSup = $grp['supplier_id'] ?? $supplierId;
                    $grpOneTime = trim((string)($grp['one_time_supplier_name'] ?? $oneTimeName));
                    if (empty($grpSup) && empty($grpOneTime)) {
                        $validator->errors()->add("groups.{$idx}.supplier_id", 'يجب تحديد المورد للمجموعة رقم ' . ($idx + 1));
                    }
                }
                return;
            }

            if (empty($supplierId) && empty($oneTimeName)) {
                $validator->errors()->add('supplier_id', 'يجب اختيار مورد معتمد أو إدخال اسم مورد لعملية واحدة فقط.');
                return;
            }

            if ($supplierId) {
                $supplier = Supplier::find($supplierId);
                if ($supplier && ! $supplier->is_active) {
                    $validator->errors()->add('supplier_id', 'The selected supplier is inactive.');
                }
            }
        });
    }
}
