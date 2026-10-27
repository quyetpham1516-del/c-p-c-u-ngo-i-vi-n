'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/StationManager').then((m) => m.StationManager), { ssr: false });
