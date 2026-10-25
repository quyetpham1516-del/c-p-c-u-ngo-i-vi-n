'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Security').then((m) => m.Security), { ssr: false });
