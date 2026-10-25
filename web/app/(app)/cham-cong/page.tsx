'use client';
import dynamic from 'next/dynamic';

export default dynamic(() => import('../../../src/screens/AttendanceScan').then((m) => m.AttendanceScan), { ssr: false });
