import './index.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initSentry } from './observability/sentry';

// Initialize Sentry before React
initSentry();

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}