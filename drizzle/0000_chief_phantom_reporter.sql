CREATE TABLE `extractions` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`state` text NOT NULL,
	`reserved_nano` integer NOT NULL,
	`cost_nano` integer,
	`created_at` text NOT NULL,
	`response_id` text,
	`request_id` text,
	`usage` text,
	`result` text,
	`note` text
);
