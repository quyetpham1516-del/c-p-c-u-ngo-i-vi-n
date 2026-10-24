'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Eoc').then((m) => m.Eoc), { ssr: false });
