import * as functions from '@google-cloud/functions-framework';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRouter from './routes/auth'; // Assuming auth routes are in ./routes/auth.ts

const app = express();

// --- Middleware ---
// Enable CORS for all origins - adjust in production if needed!
app.use(cors({ origin: true })); 
app.use(cookieParser()); // Needed for reading cookies set by /ext-auth
app.use(express.json()); // If you need to parse JSON bodies in other routes
app.use(express.urlencoded({ extended: true })); // If you need to parse URL-encoded bodies

// --- Routes ---
// Mount the authentication router
// Requests to /api/auth/... will be handled by authRouter
app.use('/api/auth', authRouter); 

// Simple root path handler (optional)
app.get('/', (req, res) => {
  res.send('Notisky Auth Function is running!');
});

// --- Export for Google Cloud Functions ---
// The name 'notiskyAuth' must match the target in package.json ('start' and 'deploy' scripts)
// and the entry point specified during deployment.
functions.http('notiskyAuth', app); 

// Note: No app.listen() here - Functions Framework handles serving. 