# Public sign-up

Off until a platform operator switches it on at Platform → Sign-ups. While off, `/pricing` and `/signup` do not exist. They are served
only on addresses that serve the platform, never on a customer's address.

## The flow

1. **Pricing** (`/pricing`) lists the plans marked "Show on the public pricing page" on Platform → Plans & billing. Prices live there, so
   changing a price needs no code.
2. **The form** (`/signup`) records a `SignupRequest`. It never creates a customer.
3. **Confirm email.** A link (48 hours) opens a page with a button. It takes a press because mail scanners open links on their own.
4. **An operator approves** at Platform → Sign-ups. Approve calls `createCustomer` itself, so a sign-up gets exactly what Add customer
   gives: roles, workspace, plan with its trial, address and the owner's invitation. There is no second way to make a customer.

## Rules worth not undoing

- **The answer is the same for a new, waiting or existing email**, so the form cannot be used to find out who uses the product.
- **Robots:** a hidden field and a signed time stamp (posted within 2.5 s, or forged, is told it worked and nothing is kept), 8 tries per
  connection per hour, and at most 500 open requests.
- **One open request per email**, by a partial unique index.
- **Only a hash of the confirmation token is stored.** The email itself is held encrypted for the worker and wiped when it is claimed.
- **Links are built from the platform's own address**, never from what the request claimed its host to be.
- **Approve is claimed first**, so two operators cannot make two customers. A failure puts the request back.
- **Automatic suspension is off unless the operator ticks it**, the same default as everywhere.

The worker sends the emails from the billing processor's 15-second pass. Unconfirmed requests expire, and rejected or expired ones are deleted
after 90 days. Approval cannot be skipped yet: opening a workspace without a person would need Add customer to run without an operator.
