CREATE TABLE `sync_blobs` (
	`account_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`updated_at` integer NOT NULL
);
