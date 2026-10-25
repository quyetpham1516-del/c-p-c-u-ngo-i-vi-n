'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Coverage').then((m) => m.Coverage), { ssr: false });
