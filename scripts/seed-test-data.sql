-- Seed Test Data for Registration Module
-- Run: npx wrangler d1 execute swa-portal --remote --file=scripts/seed-test-data.sql
-- Clear first if needed: npx wrangler d1 execute swa-portal --remote --command="DELETE FROM reg_guests; DELETE FROM reg_bookings;"

-- ===========================================
-- Booking 1: SWA Board Dinner (Table 01, 10 pax)
-- ===========================================
INSERT INTO reg_bookings (id, booking_ref, buyer_name, buyer_email, buyer_phone, table_id, pax, notes, created_by)
VALUES ('e3961bdd-d3a9-454f-a60b-c79e0d058970', 'REG-SWABRD', 'Lee Li Hua', 'lihua.lee@singaporewomenassociation.org', '+65 9277 6949', '01', 10, 'Board dinner - full table', 'cjtay@singaporewomenassociation.org');

INSERT INTO reg_guests (id, booking_id, table_id, seat_counter, ticket_code, guest_name, is_buyer, is_walk_in, notes) VALUES
('3be18ca7-440b-4295-aadf-a102c7729d30', 'e3961bdd-d3a9-454f-a60b-c79e0d058970', '01', 1, '01-01', 'Lee Li Hua', 1, 0, NULL),
('3eb40685-38cc-41ac-972f-fd82b46e5502', 'e3961bdd-d3a9-454f-a60b-c79e0d058970', '01', 2, '01-02', 'Dr Stephanie Young', 0, 0, NULL),
('0c16cc4f-7c98-4556-acf3-9674ae07094e', 'e3961bdd-d3a9-454f-a60b-c79e0d058970', '01', 3, '01-03', 'Angela Wong', 0, 0, NULL),
('c4c53d42-e03c-44b0-9b5a-afd2c4461373', 'e3961bdd-d3a9-454f-a60b-c79e0d058970', '01', 4, '01-04', 'Roxanne Zhang', 0, 0, NULL),
('6498268b-c54a-48e8-aff1-0f004dcca6bf', 'e3961bdd-d3a9-454f-a60b-c79e0d058970', '01', 5, '01-05', 'Joyce Yeo', 0, 0, 'Vegetarian'),
('1d4235d2-5981-4b58-a292-54ad6beb3825', 'e3961bdd-d3a9-454f-a60b-c79e0d058970', '01', 6, '01-06', 'Lynette Lee', 0, 0, NULL),
('7fec4744-f3a1-482b-85a7-b72f9ffc37fb', 'e3961bdd-d3a9-454f-a60b-c79e0d058970', '01', 7, '01-07', NULL, 0, 0, NULL),
('366f9d12-9a06-42a1-b25c-359ea763e9b0', 'e3961bdd-d3a9-454f-a60b-c79e0d058970', '01', 8, '01-08', NULL, 0, 0, NULL),
('08aba758-fb93-4abf-b7f5-521e00bbb814', 'e3961bdd-d3a9-454f-a60b-c79e0d058970', '01', 9, '01-09', NULL, 0, 0, NULL),
('3ebbfc94-d14b-4a77-a228-02a2f39ff427', 'e3961bdd-d3a9-454f-a60b-c79e0d058970', '01', 10, '01-10', NULL, 0, 0, NULL);

-- ===========================================
-- Booking 2: Acme Corp (VIP-1, 6 pax)
-- ===========================================
INSERT INTO reg_bookings (id, booking_ref, buyer_name, buyer_email, buyer_phone, table_id, pax, notes, created_by)
VALUES ('e530130f-63fc-4785-b042-c0009b0f5d31', 'REG-ACME01', 'David Chen', 'david.chen@acmecorp.com', '+65 9123 4567', 'VIP-1', 6, NULL, 'cjtay@singaporewomenassociation.org');

INSERT INTO reg_guests (id, booking_id, table_id, seat_counter, ticket_code, guest_name, is_buyer, is_walk_in, notes) VALUES
('0139f25b-0ff8-4a3f-8aa4-5d36e34beaab', 'e530130f-63fc-4785-b042-c0009b0f5d31', 'VIP-1', 1, 'V1-01', 'David Chen', 1, 0, NULL),
('c6760d23-0202-43f3-8479-50c4ad3dec17', 'e530130f-63fc-4785-b042-c0009b0f5d31', 'VIP-1', 2, 'V1-02', 'Sarah Lim', 0, 0, 'Halal'),
('456d5a37-9e28-4c33-ac81-a1f03c3b4e40', 'e530130f-63fc-4785-b042-c0009b0f5d31', 'VIP-1', 3, 'V1-03', 'Michael Tan', 0, 0, NULL),
('8ad5d17a-9562-48f6-a2c7-2237d104c54c', 'e530130f-63fc-4785-b042-c0009b0f5d31', 'VIP-1', 4, 'V1-04', 'Priya Sharma', 0, 0, NULL),
('5a87c012-adf2-40e9-81d0-7433f6ed7978', 'e530130f-63fc-4785-b042-c0009b0f5d31', 'VIP-1', 5, 'V1-05', NULL, 0, 0, NULL),
('5493d740-5719-4e91-b5a1-1f6de2bbaf51', 'e530130f-63fc-4785-b042-c0009b0f5d31', 'VIP-1', 6, 'V1-06', NULL, 0, 0, NULL);

-- ===========================================
-- Booking 3: Jane Smith (Table 02, 3 pax)
-- ===========================================
INSERT INTO reg_bookings (id, booking_ref, buyer_name, buyer_email, buyer_phone, table_id, pax, notes, created_by)
VALUES ('04f14fa0-92c9-4d37-805a-393977aaa0db', 'REG-SMITH9', 'Jane Smith', 'jane.smith@example.com', NULL, '02', 3, NULL, 'cjtay@singaporewomenassociation.org');

INSERT INTO reg_guests (id, booking_id, table_id, seat_counter, ticket_code, guest_name, is_buyer, is_walk_in, notes) VALUES
('517b18ed-e2d5-4b94-a6b6-65c6348d247d', '04f14fa0-92c9-4d37-805a-393977aaa0db', '02', 1, '02-01', 'Jane Smith', 1, 0, NULL),
('c141674b-882f-4513-b3bf-97ce1638529f', '04f14fa0-92c9-4d37-805a-393977aaa0db', '02', 2, '02-02', 'Robert Smith', 0, 0, NULL),
('b133ff9c-7e49-43d3-8be5-efe1e1e2fb5a', '04f14fa0-92c9-4d37-805a-393977aaa0db', '02', 3, '02-03', NULL, 0, 0, NULL);