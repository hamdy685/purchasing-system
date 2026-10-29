<?php

namespace App\Exceptions;

/**
 * The Actual PO total is above the high-value threshold and no (valid) reason was given.
 * Thrown inside the finalisation transaction so nothing is saved.
 */
class HighValueReasonRequiredException extends \RuntimeException
{
    public function __construct(public readonly float $grandTotal, public readonly float $threshold)
    {
        parent::__construct(sprintf(
            'قيمة أمر الشراء الفعلي %s جنيه تتجاوز %s جنيه. اكتب سبب الإصدار (10 أحرف على الأقل).',
            number_format($grandTotal, 2),
            number_format($threshold, 0)
        ));
    }
}
