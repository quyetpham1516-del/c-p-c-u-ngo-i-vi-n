'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../src/screens/Verify').then((m) => m.Verify), { ssr: false });
