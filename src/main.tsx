import { createRoot } from 'react-dom/client';
import App from './App';
import { loadCityData } from './data/cityData';
import './ui/styles.css';

loadCityData().then((city) => createRoot(document.getElementById('root')!).render(<App city={city} />));
