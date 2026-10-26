'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/HospitalPortal').then((m) => m.HospitalPortal), { ssr: false });
