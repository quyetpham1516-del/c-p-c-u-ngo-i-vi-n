'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Reports').then((m) => m.Reports), { ssr: false });
