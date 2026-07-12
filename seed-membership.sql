-- DUMMY SEED DATA — fake membership applications for local development.
-- No real personal data. Names, NRICs, and addresses are fabricated.
-- Provides a mix of statuses so the admin applications list shows variety
-- (pending / approved / rejected) without needing to submit the form by hand.

INSERT INTO membership_applications
  (application_type, full_name, nric, address_line1, address_line2, address_postal_code,
   phone_home, phone_office, email, handphone, date_of_birth, place_of_birth, citizenship,
   occupation, hobbies, skills_experiences, other_associations, membership_intent,
   recommended_by, paynow_r2_key, signature_r2_key, signature_method, payment_reference,
   payment_amount, submitted_ip, user_agent, created_at, status, reviewed_by, reviewed_at, member_id)
VALUES
  ('new', 'Alice Applicant', 'S0000001A', '1 Test Avenue', '#01-001', '000001',
   '+65 9323 1688', '', 'cjtay@outlook.sg', '+65 9323 1688', '1990-01-01', 'Singapore', 'Singapore Citizen',
   'Test Engineer', 'Reading, cycling', 'Event logistics', 'None', 'administration',
   'Alice Cheng', NULL, 'signatures/test-sig-1.png', 'draw', 'MEM-alice-1001',
   30.00, '127.0.0.1', 'test-agent', '2026-07-10 10:00:00', 'pending', NULL, NULL, NULL),

  ('new', 'Bryan Applicant', 'S0000002B', '2 Test Avenue', '#02-002', '000002',
   '+65 9323 1688', '+65 6323 1688', 'cjtay888@gmail.com', '+65 9323 1688', '1985-05-15', 'Singapore', 'Singapore PR',
   'Test Marketer', 'Photography', 'Social media', 'None', 'services',
   'Bryan Tan', 'paynow/test-paynow-2.png', 'signatures/test-sig-2.png', 'upload', 'MEM-bryan-1002',
   30.00, '127.0.0.1', 'test-agent', '2026-07-11 14:30:00', 'pending', NULL, NULL, NULL),

  ('new', 'Candice Applicant', 'T0000003C', '3 Test Avenue', '#03-003', '000003',
   '+65 9323 1688', '', 'internal@singaporewomenassociation.org', '+65 9323 1688', '1992-09-20', 'Malaysia', 'Singapore Citizen',
   'Test Designer', 'Art, music', 'Design, branding', 'None', 'supportive',
   'Candice Lim', NULL, 'signatures/test-sig-3.png', 'draw', 'MEM-candice-1003',
   30.00, '127.0.0.1', 'test-agent', '2026-07-09 09:15:00', 'approved', 'testadmin', '2026-07-09 16:00:00', NULL),

  ('new', 'Denise Applicant', 'F0000004D', '4 Test Avenue', '#04-004', '000004',
   '+65 9323 1688', '+65 6323 1688', 'testmember04@example.com', '+65 9323 1688', '1988-12-03', 'Singapore', 'Singapore PR',
   'Test Consultant', 'Travel', 'Fundraising', 'None', 'administration',
   'Denise Wong', NULL, 'signatures/test-sig-4.png', 'draw', 'MEM-denise-1004',
   30.00, '127.0.0.1', 'test-agent', '2026-07-08 11:45:00', 'rejected', 'testadmin', '2026-07-08 17:30:00', NULL);
