'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Hr').then((m) => m.Hr), { ssr: false });
