'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Stock').then((m) => m.Stock), { ssr: false });
