'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Report').then((m) => m.Report), { ssr: false });
