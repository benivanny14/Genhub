-- ClickPesa replaces HarakaPay as the payment gateway.
-- The value is APPENDED, so the historical HARAKAPAY rows stay readable and
-- nothing is rewritten. The application only ever writes CLICKPESA now, and
-- only CLICKPESA may settle a payment (see src/lib/payments/gateway.ts).
ALTER TYPE "PaymentGateway" ADD VALUE 'CLICKPESA';
