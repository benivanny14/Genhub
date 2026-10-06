-- SonicPesa replaces ClickPesa as the payment gateway.
-- The value is APPENDED, so the historical HARAKAPAY and CLICKPESA rows stay
-- readable and nothing is rewritten. The application only ever writes SONICPESA
-- now, and only SONICPESA may settle a payment (see src/lib/payments/gateway.ts).
ALTER TYPE "PaymentGateway" ADD VALUE 'SONICPESA';
