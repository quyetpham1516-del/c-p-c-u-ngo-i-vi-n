'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Compliance').then((m) => m.Compliance), { ssr: false });
