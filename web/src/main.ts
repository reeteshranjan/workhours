import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import Unsupported from './components/Unsupported.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Missing #app element');

// Away detection, notification buttons and the rest of the alerts are Chrome features (DESIGN §8).
const supported =
  'IdleDetector' in window && 'serviceWorker' in navigator && 'Notification' in window;

mount(supported ? App : Unsupported, { target });
