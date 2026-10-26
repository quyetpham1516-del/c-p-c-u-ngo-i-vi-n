'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Logistics').then((m) => m.Logistics), { ssr: false });
