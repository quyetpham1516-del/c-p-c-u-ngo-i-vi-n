'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../../src/screens/Scan').then((m) => m.Scan), { ssr: false });
