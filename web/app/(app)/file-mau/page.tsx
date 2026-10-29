'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Sheets').then((m) => m.Sheets), { ssr: false });
