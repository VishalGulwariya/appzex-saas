CREATE TABLE `sessions` (
  `id` CHAR(64) NOT NULL,
  `userId` VARCHAR(30) NOT NULL,
  `activeAgencyId` VARCHAR(30) NULL,
  `activeClientMembershipId` VARCHAR(30) NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `revokedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), INDEX `sessions_userId_expiresAt_idx` (`userId`,`expiresAt`), INDEX `sessions_activeAgencyId_idx` (`activeAgencyId`),
  CONSTRAINT `sessions_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `sessions_activeAgencyId_fkey` FOREIGN KEY (`activeAgencyId`) REFERENCES `agencies` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `sessions_activeClientMembershipId_fkey` FOREIGN KEY (`activeClientMembershipId`) REFERENCES `client_members` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
