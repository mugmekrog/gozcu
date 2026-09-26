# Deployment Guide: Google Cloud Run + Firebase Hosting (Free Tier)

This project is architected for deployment within Google Cloud and Firebase free tiers:
- **Backend (Python / FastAPI / Pipeline)**: Google Cloud Run (Stateless container, auto scale-to-zero)
- **Frontend (React / Vite Tactical Display)**: Firebase Hosting (Global static CDN)

---

## 1. Google Cloud Run (Backend)

### 1.1 Free Tier Limits
Google Cloud Run free tier provides every month:
- **2 million requests**
- **360,000 GB-seconds** of memory (e.g. 512 MB instance running 720,000 seconds)
- **180,000 vCPU-seconds** of vCPU
- **1 GB free network egress** to North America

### 1.2 Free-Tier Deployment Settings
When deploying to Cloud Run, use the following flags to guarantee zero cost and prevent unexpected scaling:

```bash
# 1. Authenticate with Google Cloud
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

# 2. Build and Deploy directly from source to Cloud Run
gcloud run deploy goru-backend \
  --source . \
  --region europe-west1 \
  --platform managed \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 2 \
  --memory 512Mi \
  --cpu 1 \
  --timeout 60s \
  --port 8080 \
  --set-env-vars "PORT=8080"
```

> **Why these flags matter for Free Tier:**
> - `--min-instances 0`: Automatically scales to 0 instances when idle, incurring **$0.00 cost**.
> - `--max-instances 2`: Hard cap to ensure traffic spikes cannot exceed free-tier quotas.
> - `--memory 512Mi --cpu 1`: Minimal footprint. Cold start is under 200ms because fixtures are pre-baked during container build.

Note the output service URL: `https://goru-backend-xxxxx-ew.a.run.app`.

---

## 2. Firebase Hosting (Frontend)

### 2.1 Free Tier (Spark Plan)
Firebase Hosting provides on the Spark ($0/month) plan:
- **10 GB storage**
- **10 GB / month data transfer**
- Custom domain + free SSL certificate
- Global SSD-backed CDN

### 2.2 Building and Deploying Frontend

```bash
# 1. Install Firebase CLI (if not already installed)
npm install -g firebase-tools

# 2. Log in and select project
firebase login
firebase use YOUR_PROJECT_ID

# 3. Export fixtures and build frontend with Cloud Run backend URL
cd web
python ../web/scripts/export_fixtures.py
VITE_API_BASE_URL="https://goru-backend-xxxxx-ew.a.run.app" npm run build
cd ..

# 4. Deploy to Firebase Hosting
firebase deploy --only hosting
```

Your tactical display is now live at: `https://YOUR_PROJECT_ID.web.app`.

---

## 3. Local Development with Docker Compose

To run both services locally with live hot-reloading:

```bash
# Start backend (port 8080) and frontend (port 5173)
docker compose up --build

# Open tactical display in browser:
# http://localhost:5173
```

To test the exact production containers locally before deploying:

```bash
docker compose -f docker-compose.prod.yml up --build
```
