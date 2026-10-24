'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/QrLabels').then((m) => m.QrLabels), { ssr: false });
