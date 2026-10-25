'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Ops').then((m) => m.Ops), { ssr: false });
