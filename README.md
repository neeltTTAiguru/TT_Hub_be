# Trusted Tech Hub Backend

Node.js + Express API with MongoDB (Mongoose) and CORS configured for the Vite frontend.

## Prerequisites
- Node.js 18+ recommended
- npm (comes with Node)
- MongoDB running locally or a connection string

## Setup
```bash
cd /Users/joecindergrid/Desktop/crm/beCRM
npm install
```

## Environment
Create a `.env` file based on the example:
```bash
cp /Users/joecindergrid/Desktop/crm/beCRM/.env.example /Users/joecindergrid/Desktop/crm/beCRM/.env
```

Update values in `.env` as needed:
- `PORT` (default `3000`)
- `MONGODB_URI`

## Run (dev)
```bash
npm run dev
```

API base will be `http://localhost:3000` by default.

## CORS
Allowed origins are configured in:
`/Users/joecindergrid/Desktop/crm/beCRM/src/config/corsOptions.js`

Default allowed FE origins:
- `http://localhost:5173`
- `http://127.0.0.1:5173`

## Core routes
- `GET /health` returns `{ status: "ok", time: "..." }`
- `GET /company-context` returns the current Trusted Tech profile document
- `PUT /company-context` updates the company profile
- `GET /competitors` lists tracked competitors
- `POST /competitors` creates a competitor entry
- `GET /research-runs` lists research runs
- `POST /research-runs` creates a new research run
- `GET /research-runs/:id` fetches one research run
- `PATCH /research-runs/:id` updates a research run
