# beCRM (Backend)

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

## Health check
- `GET /health` returns `{ status: "ok", time: "..." }`
