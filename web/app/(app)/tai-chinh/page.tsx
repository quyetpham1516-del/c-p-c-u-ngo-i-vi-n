'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Finance').then((m) => m.Finance), { ssr: false });
