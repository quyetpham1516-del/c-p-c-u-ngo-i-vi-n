'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/Admin').then((m) => m.Admin), { ssr: false });
