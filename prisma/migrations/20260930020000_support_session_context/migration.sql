ALTER TABLE `sessions`
  ADD COLUMN `activeSupportSessionId` VARCHAR(30) NULL,
  ADD INDEX `sessions_activeSupportSessionId_idx` (`activeSupportSessionId`),
  ADD CONSTRAINT `sessions_activeSupportSessionId_fkey` FOREIGN KEY (`activeSupportSessionId`) REFERENCES `support_sessions` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
