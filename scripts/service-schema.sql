CREATE TABLE `quota` (
  `bucket` text NOT NULL,
  `quota_key` text NOT NULL,
  `used` integer NOT NULL,
  PRIMARY KEY (`bucket`, `quota_key`)
);
