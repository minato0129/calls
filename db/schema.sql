-- 先生呼び出しアプリ スキーマ (MySQL 8)
-- 時刻はすべて UTC で保存し、表示時に JST へ変換する

CREATE TABLE IF NOT EXISTS users (
  id         VARCHAR(64)  NOT NULL PRIMARY KEY,   -- Entra ID の oid(開発ログインでは email)
  email      VARCHAR(255) NOT NULL UNIQUE,
  name       VARCHAR(255) NOT NULL,
  role       ENUM('STUDENT','TEACHER') NOT NULL,
  created_at DATETIME(3)  NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rooms (
  id          VARCHAR(32)  NOT NULL PRIMARY KEY,
  owner_id    VARCHAR(64)  NOT NULL,
  subject     VARCHAR(255) NOT NULL,
  class_name  VARCHAR(255) NOT NULL,
  day_of_week TINYINT      NOT NULL,              -- 0=日 1=月 ... 6=土
  period      TINYINT      NOT NULL,              -- 時限
  created_at  DATETIME(3)  NOT NULL,
  UNIQUE KEY uq_owner_slot (owner_id, day_of_week, period),   -- 同じ先生の時間重複を防ぐ
  CONSTRAINT fk_rooms_owner FOREIGN KEY (owner_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS enrollments (            -- QR を読み取った学生
  room_id    VARCHAR(32) NOT NULL,
  user_id    VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (room_id, user_id),
  KEY idx_enroll_user (user_id),
  CONSTRAINT fk_enroll_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_enroll_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS calls (
  id          BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,  -- キューの順番は id 順
  room_id     VARCHAR(32) NOT NULL,
  student_id  VARCHAR(64) NOT NULL,
  type        ENUM('QUESTION','CHECK') NOT NULL,
  status      ENUM('WAITING','DONE','CANCELLED') NOT NULL DEFAULT 'WAITING',
  created_at  DATETIME(3) NOT NULL,
  resolved_at DATETIME(3) NULL,
  KEY idx_calls_room_status (room_id, status, id),
  CONSTRAINT fk_calls_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_calls_user FOREIGN KEY (student_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS memos (
  id         BIGINT      NOT NULL AUTO_INCREMENT PRIMARY KEY,
  room_id    VARCHAR(32) NOT NULL,
  student_id VARCHAR(64) NOT NULL,
  call_id    BIGINT      NULL,
  body       TEXT        NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_memos_room (room_id, created_at),
  CONSTRAINT fk_memos_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,   -- ルーム削除でメモも削除
  CONSTRAINT fk_memos_user FOREIGN KEY (student_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    VARCHAR(64)  NOT NULL,
  endpoint   VARCHAR(700) NOT NULL,
  p256dh     VARCHAR(255) NOT NULL,
  auth       VARCHAR(255) NOT NULL,
  created_at DATETIME(3)  NOT NULL,
  UNIQUE KEY uq_push_endpoint (endpoint),
  KEY idx_push_user (user_id),
  CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
