CREATE TABLE `users` (
  `id` VARCHAR(30) NOT NULL,
  `name` VARCHAR(160) NOT NULL,
  `email` VARCHAR(254) NOT NULL,
  `passwordHash` VARCHAR(255) NOT NULL,
  `globalRole` ENUM('USER','SUPER_ADMIN') NOT NULL DEFAULT 'USER',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE INDEX `users_email_key` (`email`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `agencies` (
  `id` VARCHAR(30) NOT NULL,
  `name` VARCHAR(160) NOT NULL,
  `slug` VARCHAR(100) NOT NULL,
  `status` ENUM('ACTIVE','SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE INDEX `agencies_slug_key` (`slug`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `agency_members` (
  `id` VARCHAR(30) NOT NULL,
  `agencyId` VARCHAR(30) NOT NULL,
  `userId` VARCHAR(30) NOT NULL,
  `role` ENUM('OWNER','ADMIN','PROJECT_MANAGER','MEMBER') NOT NULL DEFAULT 'MEMBER',
  `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE INDEX `agency_members_agencyId_userId_key` (`agencyId`,`userId`),
  UNIQUE INDEX `agency_members_agencyId_id_key` (`agencyId`,`id`), INDEX `agency_members_userId_idx` (`userId`),
  CONSTRAINT `agency_members_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `agencies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `agency_members_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `clients` (
  `id` VARCHAR(30) NOT NULL, `agencyId` VARCHAR(30) NOT NULL, `companyName` VARCHAR(180) NOT NULL,
  `contactName` VARCHAR(160) NULL, `email` VARCHAR(254) NULL, `phone` VARCHAR(40) NULL, `notes` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE INDEX `clients_agencyId_id_key` (`agencyId`,`id`), INDEX `clients_agencyId_companyName_idx` (`agencyId`,`companyName`),
  CONSTRAINT `clients_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `agencies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `client_members` (
  `id` VARCHAR(30) NOT NULL, `agencyId` VARCHAR(30) NOT NULL, `clientId` VARCHAR(30) NOT NULL, `userId` VARCHAR(30) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`),
  UNIQUE INDEX `client_members_agencyId_clientId_userId_key` (`agencyId`,`clientId`,`userId`), INDEX `client_members_userId_idx` (`userId`),
  CONSTRAINT `client_members_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `agencies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `client_members_agencyId_clientId_fkey` FOREIGN KEY (`agencyId`,`clientId`) REFERENCES `clients` (`agencyId`,`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `client_members_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `projects` (
  `id` VARCHAR(30) NOT NULL, `agencyId` VARCHAR(30) NOT NULL, `clientId` VARCHAR(30) NOT NULL, `managerId` VARCHAR(30) NULL,
  `name` VARCHAR(180) NOT NULL, `description` TEXT NULL,
  `status` ENUM('PLANNING','ACTIVE','ON_HOLD','COMPLETED','ARCHIVED') NOT NULL DEFAULT 'PLANNING',
  `priority` ENUM('LOW','MEDIUM','HIGH','URGENT') NOT NULL DEFAULT 'MEDIUM',
  `startDate` DATE NULL, `dueDate` DATE NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE INDEX `projects_agencyId_id_key` (`agencyId`,`id`), INDEX `projects_agencyId_status_idx` (`agencyId`,`status`), INDEX `projects_agencyId_clientId_idx` (`agencyId`,`clientId`),
  CONSTRAINT `projects_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `agencies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `projects_agencyId_clientId_fkey` FOREIGN KEY (`agencyId`,`clientId`) REFERENCES `clients` (`agencyId`,`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `projects_agencyId_managerId_fkey` FOREIGN KEY (`agencyId`,`managerId`) REFERENCES `agency_members` (`agencyId`,`userId`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `milestones` (
  `id` VARCHAR(30) NOT NULL, `agencyId` VARCHAR(30) NOT NULL, `projectId` VARCHAR(30) NOT NULL,
  `title` VARCHAR(180) NOT NULL, `dueDate` DATE NULL,
  `status` ENUM('PENDING','IN_PROGRESS','COMPLETED') NOT NULL DEFAULT 'PENDING', `position` INTEGER NOT NULL DEFAULT 0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE INDEX `milestones_agencyId_id_key` (`agencyId`,`id`), UNIQUE INDEX `milestones_agencyId_projectId_id_key` (`agencyId`,`projectId`,`id`), INDEX `milestones_agencyId_projectId_position_idx` (`agencyId`,`projectId`,`position`),
  CONSTRAINT `milestones_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `agencies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `milestones_agencyId_projectId_fkey` FOREIGN KEY (`agencyId`,`projectId`) REFERENCES `projects` (`agencyId`,`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `tasks` (
  `id` VARCHAR(30) NOT NULL, `agencyId` VARCHAR(30) NOT NULL, `projectId` VARCHAR(30) NOT NULL,
  `milestoneId` VARCHAR(30) NULL, `assigneeId` VARCHAR(30) NULL, `title` VARCHAR(180) NOT NULL, `description` TEXT NULL,
  `status` ENUM('TODO','IN_PROGRESS','IN_REVIEW','DONE','BLOCKED') NOT NULL DEFAULT 'TODO',
  `priority` ENUM('LOW','MEDIUM','HIGH','URGENT') NOT NULL DEFAULT 'MEDIUM', `dueDate` DATE NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE INDEX `tasks_agencyId_id_key` (`agencyId`,`id`), UNIQUE INDEX `tasks_agencyId_projectId_id_key` (`agencyId`,`projectId`,`id`), INDEX `tasks_agencyId_projectId_status_idx` (`agencyId`,`projectId`,`status`), INDEX `tasks_agencyId_assigneeId_idx` (`agencyId`,`assigneeId`),
  CONSTRAINT `tasks_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `agencies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `tasks_agencyId_projectId_fkey` FOREIGN KEY (`agencyId`,`projectId`) REFERENCES `projects` (`agencyId`,`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `tasks_agencyId_projectId_milestoneId_fkey` FOREIGN KEY (`agencyId`,`projectId`,`milestoneId`) REFERENCES `milestones` (`agencyId`,`projectId`,`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `tasks_agencyId_assigneeId_fkey` FOREIGN KEY (`agencyId`,`assigneeId`) REFERENCES `agency_members` (`agencyId`,`userId`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `task_comments` (
  `id` VARCHAR(30) NOT NULL, `agencyId` VARCHAR(30) NOT NULL, `taskId` VARCHAR(30) NOT NULL, `authorId` VARCHAR(30) NOT NULL, `body` TEXT NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`), INDEX `task_comments_agencyId_taskId_createdAt_idx` (`agencyId`,`taskId`,`createdAt`),
  CONSTRAINT `task_comments_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `agencies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `task_comments_agencyId_taskId_fkey` FOREIGN KEY (`agencyId`,`taskId`) REFERENCES `tasks` (`agencyId`,`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `task_comments_agencyId_authorId_fkey` FOREIGN KEY (`agencyId`,`authorId`) REFERENCES `agency_members` (`agencyId`,`userId`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `meetings` (
  `id` VARCHAR(30) NOT NULL, `agencyId` VARCHAR(30) NOT NULL, `projectId` VARCHAR(30) NOT NULL, `title` VARCHAR(180) NOT NULL,
  `scheduledAt` DATETIME(3) NOT NULL, `notes` TEXT NULL, `clientVisible` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`), INDEX `meetings_agencyId_projectId_scheduledAt_idx` (`agencyId`,`projectId`,`scheduledAt`),
  CONSTRAINT `meetings_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `agencies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `meetings_agencyId_projectId_fkey` FOREIGN KEY (`agencyId`,`projectId`) REFERENCES `projects` (`agencyId`,`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `feedback` (
  `id` VARCHAR(30) NOT NULL, `agencyId` VARCHAR(30) NOT NULL, `projectId` VARCHAR(30) NOT NULL, `submittedBy` VARCHAR(30) NULL,
  `title` VARCHAR(180) NOT NULL, `description` TEXT NOT NULL, `status` ENUM('OPEN','IN_PROGRESS','RESOLVED','CLOSED') NOT NULL DEFAULT 'OPEN',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE INDEX `feedback_agencyId_id_key` (`agencyId`,`id`), INDEX `feedback_agencyId_projectId_status_idx` (`agencyId`,`projectId`,`status`),
  CONSTRAINT `feedback_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `agencies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `feedback_agencyId_projectId_fkey` FOREIGN KEY (`agencyId`,`projectId`) REFERENCES `projects` (`agencyId`,`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `feedback_submittedBy_fkey` FOREIGN KEY (`submittedBy`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `feedback_comments` (
  `id` VARCHAR(30) NOT NULL, `agencyId` VARCHAR(30) NOT NULL, `feedbackId` VARCHAR(30) NOT NULL, `authorId` VARCHAR(30) NOT NULL,
  `body` TEXT NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`), INDEX `feedback_comments_agencyId_feedbackId_createdAt_idx` (`agencyId`,`feedbackId`,`createdAt`),
  CONSTRAINT `feedback_comments_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `agencies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `feedback_comments_agencyId_feedbackId_fkey` FOREIGN KEY (`agencyId`,`feedbackId`) REFERENCES `feedback` (`agencyId`,`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `feedback_comments_authorId_fkey` FOREIGN KEY (`authorId`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `files` (
  `id` VARCHAR(30) NOT NULL, `agencyId` VARCHAR(30) NOT NULL, `projectId` VARCHAR(30) NULL, `taskId` VARCHAR(30) NULL, `feedbackId` VARCHAR(30) NULL,
  `storageKey` VARCHAR(512) NOT NULL, `fileName` VARCHAR(255) NOT NULL, `mimeType` VARCHAR(160) NOT NULL, `sizeBytes` BIGINT NOT NULL,
  `visibility` ENUM('INTERNAL','CLIENT_SHARED') NOT NULL DEFAULT 'INTERNAL',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE INDEX `files_storageKey_key` (`storageKey`), INDEX `files_agencyId_projectId_idx` (`agencyId`,`projectId`), INDEX `files_agencyId_taskId_idx` (`agencyId`,`taskId`), INDEX `files_agencyId_feedbackId_idx` (`agencyId`,`feedbackId`),
  CONSTRAINT `files_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `agencies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `files_agencyId_projectId_fkey` FOREIGN KEY (`agencyId`,`projectId`) REFERENCES `projects` (`agencyId`,`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `files_agencyId_projectId_taskId_fkey` FOREIGN KEY (`agencyId`,`projectId`,`taskId`) REFERENCES `tasks` (`agencyId`,`projectId`,`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `files_agencyId_feedbackId_fkey` FOREIGN KEY (`agencyId`,`feedbackId`) REFERENCES `feedback` (`agencyId`,`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `activity_logs` (
  `id` VARCHAR(30) NOT NULL, `agencyId` VARCHAR(30) NOT NULL, `actorId` VARCHAR(30) NULL,
  `eventType` VARCHAR(120) NOT NULL, `entityType` VARCHAR(80) NOT NULL, `entityId` VARCHAR(30) NOT NULL,
  `visibility` ENUM('INTERNAL','CLIENT_VISIBLE') NOT NULL DEFAULT 'INTERNAL', `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), INDEX `activity_logs_agencyId_createdAt_idx` (`agencyId`,`createdAt`), INDEX `activity_logs_agencyId_entityType_entityId_idx` (`agencyId`,`entityType`,`entityId`),
  CONSTRAINT `activity_logs_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `agencies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `activity_logs_agencyId_actorId_fkey` FOREIGN KEY (`agencyId`,`actorId`) REFERENCES `agency_members` (`agencyId`,`userId`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `agency_settings` (
  `agencyId` VARCHAR(30) NOT NULL, `timezone` VARCHAR(64) NOT NULL DEFAULT 'UTC',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`agencyId`), CONSTRAINT `agency_settings_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `agencies` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `support_sessions` (
  `id` VARCHAR(30) NOT NULL, `superAdminId` VARCHAR(30) NOT NULL, `agencyId` VARCHAR(30) NOT NULL,
  `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `endedAt` DATETIME(3) NULL, `reason` VARCHAR(500) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`), INDEX `support_sessions_agencyId_startedAt_idx` (`agencyId`,`startedAt`), INDEX `support_sessions_superAdminId_startedAt_idx` (`superAdminId`,`startedAt`),
  CONSTRAINT `support_sessions_superAdminId_fkey` FOREIGN KEY (`superAdminId`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `support_sessions_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `agencies` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
