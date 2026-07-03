import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig(function () { return ({
    plugins: [react(), tailwindcss()],
    base: process.env.VITE_BASE_PATH || '/Reactor-Attractor/',
    build: {
        outDir: 'dist',
    },
}); });
