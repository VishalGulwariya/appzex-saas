CREATE TABLE `platform_activity` (
  `id` VARCHAR(30) NOT NULL,
  `actorId` VARCHAR(30) NOT NULL,
  `agencyId` VARCHAR(30) NULL,
  `eventType` VARCHAR(120) NOT NULL,
  `entityType` VARCHAR(80) NOT NULL,
  `entityId` VARCHAR(30) NOT NULL,
  `summary` VARCHAR(500) NULL,
  `metadata` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `platform_activity_createdAt_idx` (`createdAt`),
  INDEX `platform_activity_agencyId_createdAt_idx` (`agencyId`,`createdAt`),
  CONSTRAINT `platform_activity_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `platform_activity_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `agencies` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
