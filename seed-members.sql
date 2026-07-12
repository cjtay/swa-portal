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

INSERT INTO members (name, slug, role, email, mobile, job_title, photo_url, photo_alt, description, category, can_login, show_on_website, has_namecard, address_line1, address_line2, address_postal_code, address_country, facebook, linkedin, instagram, tiktok, youtube, sort_order) VALUES
('Alice Cheng', 'alice', 'President', 'cjtay@outlook.sg', '+65 9323 1688', 'President', 'alice', 'Alice Cheng', 'Test president record for local development.', 'committee', 1, 1, 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', '', '', '', '', '', 1),
('Bryan Tan', 'bryan', '1st Vice President', 'cjtay888@gmail.com', '+65 9323 1688', '1st Vice President', 'bryan', 'Bryan Tan', 'Test vice-president record for local development.', 'committee', 1, 1, 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', '', '', '', '', '', 2),
('Candice Lim', 'candice', 'Honorary Secretary', 'internal@singaporewomenassociation.org', '+65 9323 1688', 'Honorary Secretary', 'candice', 'Candice Lim', 'Test secretary record for local development.', 'committee', 1, 1, 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', '', '', '', '', '', 3),
('Denise Wong', 'denise', '2nd Vice President', 'testmember04@example.com', '+65 9323 1688', '2nd Vice President', 'denise', 'Denise Wong', 'Test vice-president record for local development.', 'committee', 1, 1, 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', '', '', '', '', '', 4),
('Ethan Goh', 'ethan', '3rd Vice President', 'testmember05@example.com', '+65 9323 1688', '3rd Vice President', 'ethan', 'Ethan Goh', 'Test vice-president record for local development.', 'committee', 1, 1, 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', '', '', '', '', '', 5),
('Felicia Ng', 'felicia', 'Honorary Treasurer', 'testmember06@example.com', '+65 9323 1688', 'Honorary Treasurer', 'felicia', 'Felicia Ng', 'Test treasurer record for local development.', 'committee', 1, 1, 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', '', '', '', '', '', 6),
('Gerald Lee', 'gerald', 'Finance', 'testmember07@example.com', '+65 9323 1688', 'Finance', 'gerald', 'Gerald Lee', 'Test finance record for local development.', 'committee', 1, 0, 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', '', '', '', '', '', 7),
('Hannah Koh', 'hannah', 'Assistant Secretary', 'testmember08@example.com', '+65 9323 1688', 'Assistant Secretary', 'hannah', 'Hannah Koh', 'Test assistant secretary record for local development.', 'committee', 1, 1, 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', '', '', '', '', '', 8),
('Ivan Chua', 'ivan', 'Communications Director', 'testmember09@example.com', '+65 9323 1688', 'Communications Director', 'ivan', 'Ivan Chua', 'Test communications record for local development.', 'committee', 1, 1, 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', '', '', '', '', '', 9),
('Jolene Yeo', 'jolene', 'Programme Director', 'testmember10@example.com', '+65 9323 1688', 'Programme Director', 'jolene', 'Jolene Yeo', 'Test programme director record for local development.', 'committee', 1, 1, 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', '', '', '', '', '', 10),
('Khai Lim', 'khai', 'Board member', 'testmember11@example.com', '+65 9323 1688', 'Board member', 'khai', 'Khai Lim', 'Test board member record for local development.', 'committee', 1, 1, 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', '', '', '', '', '', 11),
('Lena Tan', 'lena', 'Board member', 'testmember12@example.com', '+65 9323 1688', 'Board member', 'lena', 'Lena Tan', 'Test board member record for local development.', 'committee', 1, 1, 1, '1 Test Avenue', '#01-001', '000001', 'Singapore', '', '', '', '', '', 12);

-- Admin accounts (can_login = 1, no namecard/website display). The first uses
-- the project owner's address so it matches the dev-bypass IT-admin identity
-- (IT_ADMIN_EMAILS[0] in src/constants/portal.ts).
INSERT INTO members (name, slug, role, email, category, can_login, show_on_website, has_namecard, sort_order) VALUES
('Test Admin', 'testadmin', 'IT Admin', 'cjtay@singaporewomenassociation.org', 'admin', 1, 0, 0, 100),
('System Account', 'system', 'System', 'system@example.com', 'admin', 1, 0, 0, 101);
