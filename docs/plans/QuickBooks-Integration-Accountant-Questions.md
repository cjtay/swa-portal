# QuickBooks Integration — Questions for the Accountant

Status: waiting for answers. Created 26-08-2026.

## Why this document exists

We plan to add a "Post to QuickBooks" button to the approvals feature. When a payment voucher reaches Paid status, the button will send the voucher to QuickBooks Online through Intuit's API. Three build decisions depend on how the accountant already works in QuickBooks. Until they answer, we build against the working defaults listed at the bottom of this page.

## Can a wrong post be corrected in QuickBooks Online?

Yes. A posted Expense, Cheque, or Journal entry can be edited, voided, or deleted directly inside QuickBooks Online, the same as one typed in by hand. The button only creates the record once. It does not sync changes afterwards, so the accountant fixes any mistake in QuickBooks itself. The portal keeps its own audit trail of what was posted.

One thing to flag: after a fix in QuickBooks, the portal record and the QuickBooks record can disagree. Whoever fixes it should note why, so the mismatch is explainable at year end.

## Questions to send

### How payments are recorded

1. When SWA pays a supplier by PayNow, bank transfer, cheque, or cash, how do you record it in QuickBooks today? An Expense, a Cheque, a Bill plus Bill Payment, or a journal entry?
2. Do you create a vendor record in QuickBooks for each payee? If yes, should the portal find the matching vendor by name and create one when it does not exist?
3. Which bank and cash accounts sit in QuickBooks (for example DBS current, petty cash)? Should the payment method decide which account the money is drawn from?
4. Is the QuickBooks company file set to Singapore dollars?

### Accounts and references

5. Which expense accounts do you use for day-to-day spending, and how would you map our 8 voucher categories (office supplies, office maintenance, vendor payment, payroll, and the rest) onto them?
6. Should the voucher number, for example PV26-0801, appear on the QuickBooks record so you can match entries to vouchers?
7. If a posted entry is wrong, do you want to fix it in QuickBooks yourself, or should the portal block posting until someone checks? (In QuickBooks you can already edit, void, or delete any entry.)

### Who posts

8. Who should do the posting? The finance approvers (YS and Joyce) from the portal, or would you rather receive the vouchers and enter them yourselves?
9. Do you want an email when a voucher is posted, or is a monthly check inside QuickBooks enough?

## Working defaults until answered

These are the assumptions the implementation plan will use until the accountant replies.

| Decision | Default | Question that changes it |
| --- | --- | --- |
| QuickBooks record type | Expense (Cheque for cheque payments) | 1 |
| Payee handling | Find vendor by name, create when missing | 2 |
| Bank account | Payment method maps to a bank account set in admin settings | 3 |
| Currency | Singapore dollars | 4 |
| Expense account | Category-to-account map in admin settings | 5 |
| Voucher number on record | Yes, in the memo field | 6 |
| Who can post | Finance approvers plus IT admin | 8 |
| Posting notification | None in phase 1 | 9 |
| Attachments | Voucher data only, no receipts in phase 1 | settled 26-08-2026 |

## Answers

Record each reply here, then update the defaults table and the implementation plan.

| # | Answer | Date |
| --- | --- | --- |
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |
| 5 | | |
| 6 | | |
| 7 | | |
| 8 | | |
| 9 | | |
