// Browser entry point (index.html loads it): global styles, the api warm-up, and the React root.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { warmUp } from './api.ts';
import './styles.css';

// Wake the api the moment the page loads (ADR-0002): by the time the customer has filled the form,
// the serverless function and its database connection are warm. Called here, outside React, so it
// fires exactly once per page load: StrictMode runs effects twice in development, and moving
// between pages inside the app (pushState) is not a new load and needs no second warm-up.
warmUp();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
