'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Qms').then((m) => m.Qms), { ssr: false });
