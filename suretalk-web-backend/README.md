# SureTalk Web Backend

Modern backend for SureTalk voice messaging platform, built with TypeScript, Express, Prisma, and PostgreSQL.

## 🚀 Features

- 🔐 JWT-based authentication with session management
- 👤 User management with profiles and dashboards
- 🎤 Voice notes management with tier-based limits
- 📞 Contacts management
- 💾 S3 integration for voice storage
- 💳 Stripe integration for subscriptions
- 📊 PostgreSQL with Prisma ORM
- 🐳 Docker-ready for deployment
- 📱 RESTful API design

## 🏗️ Architecture

- **Runtime**: Node.js 18
- **Framework**: Express.js
- **Database**: PostgreSQL (Aurora)
- **ORM**: Prisma
- **Authentication**: JWT with sessions
- **Storage**: AWS S3
- **Deployment**: AWS App Runner

## 📦 Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/suretalk-web-backend.git
   cd suretalk-web-backend