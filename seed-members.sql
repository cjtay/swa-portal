-- DUMMY SEED DATA — NOT REAL MEMBERS.
-- Safe for local development. Contains no real personal data. All names,
-- emails (except the project owner's own test addresses), and addresses are
-- fabricated. Every record shares one mobile number (the owner's test line)
-- so login/OTP flows can be exercised without exposing anyone's real number.
--
-- Email policy:
--   * The 4 real test addresses (cjtay@outlook.sg, cjtay888@gmail.com,
--     cjtay@singaporewomenassociation.org, internal@singaporewomenassociation.org)
--     are attached to login-capable members so you can test the OTP flow.
--   * Remaining members use clearly-fake example.com addresses, because the
--     members.email column is UNIQUE — duplicates are not allowed.
--
-- Login eligibility is determined by the can_login flag, not the email domain.
--
-- Public-website columns (slug, photo_url, photo_alt, description,
-- show_on_website, has_namecard, facebook, linkedin, instagram, tiktok,
-- youtube) were dropped on 19-07-2026 — see migration 006. swa-portal is
-- now isolated from the public swa2024 website.

INSERT INTO members (name, role, email, mobile, job_title, category, can_login, address_line1, address_line2, address_postal_code, address_country, sort_order, membership_status, fee_due_date, fee_waived) VALUES
('Alice Cheng', 'President', 'cjtay@outlook.sg', '+65 9323 1688', 'President', 'committee', 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', 1, 'active', '2027-01-31', 0),
('Bryan Tan', '1st Vice President', 'cjtay888@gmail.com', '+65 9323 1688', '1st Vice President', 'committee', 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', 2, 'active', '2027-01-31', 0),
('Candice Lim', 'Honorary Secretary', 'internal@singaporewomenassociation.org', '+65 9323 1688', 'Honorary Secretary', 'committee', 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', 3, 'active', '2027-01-31', 0),
('Denise Wong', '2nd Vice President', 'testmember04@example.com', '+65 9323 1688', '2nd Vice President', 'committee', 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', 4, 'active', '2027-01-31', 0),
('Ethan Goh', '3rd Vice President', 'testmember05@example.com', '+65 9323 1688', '3rd Vice President', 'committee', 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', 5, 'active', '2027-01-31', 0),
('Felicia Ng', 'Honorary Treasurer', 'testmember06@example.com', '+65 9323 1688', 'Honorary Treasurer', 'committee', 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', 6, 'active', '2027-01-31', 0),
('Gerald Lee', 'Finance', 'testmember07@example.com', '+65 9323 1688', 'Finance', 'committee', 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', 7, 'active', '2027-01-31', 0),
('Hannah Koh', 'Assistant Secretary', 'testmember08@example.com', '+65 9323 1688', 'Assistant Secretary', 'committee', 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', 8, 'active', '2027-01-31', 0),
('Ivan Chua', 'Communications Director', 'testmember09@example.com', '+65 9323 1688', 'Communications Director', 'committee', 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', 9, 'active', '2027-01-31', 0),
('Jolene Yeo', 'Programme Director', 'testmember10@example.com', '+65 9323 1688', 'Programme Director', 'committee', 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', 10, 'active', '2027-01-31', 0),
('Khai Lim', 'Board member', 'testmember11@example.com', '+65 9323 1688', 'Board member', 'committee', 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', 11, 'active', '2027-01-31', 0),
('Lena Tan', 'Board member', 'testmember12@example.com', '+65 9323 1688', 'Board member', 'committee', 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', 12, 'active', '2027-01-31', 0);

-- Office admin account (category='admin'). Its email is also first in
-- IT_ADMIN_EMAILS (src/constants/portal.ts), so this identity holds BOTH
-- office admin and IT admin powers. IT admins who need no directory row
-- (e.g. system@singaporewomenassociation.org) are governed solely by the
-- IT_ADMIN_EMAILS constant — send-otp lets them log in without a row.
INSERT INTO members (name, role, email, category, can_login, sort_order, membership_status, fee_waived) VALUES
('Test Admin', 'Office Admin', 'cjtay@singaporewomenassociation.org', 'admin', 1, 100, 'active', 1);

-- Approval workflow test identities (docs/plans/Approval-Workflow-Implementation-
-- Plan.md §13). Shared inboxes the owner controls stand in for the four
-- approvers — the members table forbids duplicate emails, so locally there is
-- one row per shared inbox rather than four. Production gives each person
-- their own address (and the audit log then names people properly).
-- All three rows set can_login = 1 so the dev quick-login picker lists them.
INSERT INTO members (name, role, email, mobile, job_title, category, can_login, address_line1, address_line2, address_postal_code, address_country, sort_order, membership_status, fee_due_date, fee_waived) VALUES
('Purchase Approver (test)', 'Purchase Approver', 'approval@singaporewomenassociation.org', '+65 9323 1688', 'Purchase Approver (shared test inbox)', 'committee', 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', 101, 'active', '2027-01-31', 1),
('Finance Approver (test)', 'Finance Approver', 'finance@singaporewomenassociation.org', '+65 9323 1688', 'Finance Approver (shared test inbox)', 'committee', 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', 102, 'active', '2027-01-31', 1),
('Jolene Lim', 'Office Admin', 'jolene.lim@singaporewomenassociation.org', '+65 9323 1688', 'Office Admin', 'admin', 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', 103, 'active', '2027-01-31', 1);
