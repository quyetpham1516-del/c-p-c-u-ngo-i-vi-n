'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Research').then((m) => m.Research), { ssr: false });
