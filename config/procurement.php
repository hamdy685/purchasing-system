<?php

return [
    /*
    |--------------------------------------------------------------------------
    | Default Department Reviewer Emails (Fallback)
    |--------------------------------------------------------------------------
    |
    | Used as a fallback when a department does not have an explicitly assigned
    | manager_user_id or active reviewer assigned in the database.
    |
    */
    'default_department_reviewers' => [
        'EXECUTION' => env('REVIEWER_EMAIL_EXECUTION', 'ayman@gmail.com'),
        'BUILDINGS' => env('REVIEWER_EMAIL_BUILDINGS', 'hatem@gmail.com'),
        'FINISHING' => env('REVIEWER_EMAIL_FINISHING', 'kheshen@gmail.com'),
        'LICENSES' => env('REVIEWER_EMAIL_LICENSES', 'mostafa@gmail.com'),
        'BUFFET' => env('REVIEWER_EMAIL_BUFFET', 'amr@gmail.com'),
        'DEVELOPMENT' => env('REVIEWER_EMAIL_DEVELOPMENT', 'mahmoud@gmail.com'),
        'MARKETING' => env('REVIEWER_EMAIL_MARKETING', 'karim.marketing@gmail.com'),
        'SALES' => env('REVIEWER_EMAIL_SALES', 'amr.sales@gmail.com'),
    ],

    /*
    |--------------------------------------------------------------------------
    | Mandatory Department-Consolidated Purchase Orders
    |--------------------------------------------------------------------------
    |
    | Requests of these departments (matched by departments.code, never by the
    | Arabic display name) are issued as one consolidated PO per supplier and
    | compatible scope instead of one PO per item. Off by default: other
    | departments, and all departments while disabled, keep today's behavior.
    |
    */
    'consolidated_po' => [
        'enabled' => (bool) env('CONSOLIDATED_PO_ENABLED', false),
        'department_codes' => ['FINISHING', 'OFFICE', 'LICENSES', 'DEVELOPMENT'],
    ],

    /*
    |--------------------------------------------------------------------------
    | Actual PO high-value warning (all departments)
    |--------------------------------------------------------------------------
    |
    | An Actual PO whose grand total (after discount and tax) is above this amount
    | is issued only with a written reason, and the general manager and accounting
    | are notified. It is a warning with a reason, not a block.
    |
    */
    'actual_po_high_value_threshold' => (float) env('ACTUAL_PO_HIGH_VALUE_THRESHOLD', 500000),
    'actual_po_high_value_reason_min_length' => 10,
];
