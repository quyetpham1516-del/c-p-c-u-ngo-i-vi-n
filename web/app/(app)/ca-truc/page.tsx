'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Duty').then((m) => m.Duty), { ssr: false });
